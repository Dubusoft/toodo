import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatAttachmentId, FIRST_CHANNEL } from "../domain/chat.ts";
import { postAgentMessage, postUserMessage } from "../storage/chat.ts";
import { Browser } from "../push/testing.ts";
import { AccessVerifier, parseAccessConfig } from "./access.ts";
import { MAX_FAILURES } from "./auth.ts";
import { AGENT, startTestServer, type TestServer, WEB } from "./http-fixtures.ts";
import { READY } from "./event-log.ts";

let servers: TestServer[] = [];

async function start(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const server = await startTestServer(options);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

const SQLITE_MAGIC = "SQLite format 3\0";

function workspaceNames(server: TestServer): string[] {
  return server.services.storage.listWorkspaces().map((workspace) => workspace.name);
}

function addWorkspace(server: TestServer, name: string) {
  server.services.storage.createWorkspace({ name, description: null, repository: null });
}

describe("routes", () => {
  test("only API routes need the web token", async () => {
    const server = await start();
    const status = async (method: string, path: string, token?: string) => (await server.fetch(method, path, { token })).status;
    const body = async (path: string, token?: string) => (await server.fetch("POST", path, { token })).text();
    const rpc = "/api/rpc/list_workspaces";
    expect(await status("POST", rpc)).toBe(401);
    expect(await status("POST", rpc, AGENT)).toBe(401);
    expect(await status("POST", rpc, WEB)).toBe(200);
    expect(await status("GET", "/api/events")).toBe(401);
    expect(await status("GET", "/api/nothing")).toBe(401);
    expect(await status("GET", "/api/nothing", WEB)).toBe(404);
    expect(await status("GET", rpc, WEB)).toBe(405);
    expect(await body(rpc)).toContain("Toodo API: the request has no Authorization header");
    expect(await body(rpc, AGENT)).toContain("this is the MCP token for agents");
    expect(await body(rpc, "nope")).toContain("neither the web sign-in token");
    // Without a web build, other paths are simply not there.
    expect(await status("GET", "/")).toBe(404);
    expect(await status("GET", "/tasks")).toBe(404);
    expect(await status("GET", "/oauth/authorize")).toBe(404);
  });

  test("the web app is served without a token but not for API paths", async () => {
    const web = mkdtempSync(join(tmpdir(), "toodo-web-"));
    writeFileSync(join(web, "index.html"), "<html></html>");
    writeFileSync(join(web, "app.js"), "console.log(1)");
    const server = await start({ webDir: web });
    const get = (path: string, token?: string) => server.fetch("GET", path, { token });
    expect((await get("/")).status).toBe(200);
    const deep = await get("/tasks/1");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("<html></html>");
    const script = await get("/app.js");
    expect(await script.text()).toBe("console.log(1)");
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await (await get("/../../etc/passwd")).text()).toBe("<html></html>");
    expect((await get("/api/nothing")).status).toBe(401);
    expect((await get("/api/nothing", WEB)).status).toBe(404);
  });

  test("events start ready and announce changes", async () => {
    const server = await start();
    const response = await server.fetch("GET", "/api/events", { token: WEB });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await until("\n\n");
    expect(text).toBe(`id: ab12-0\nevent: ${READY}\ndata: \n\n`);
    const workspace = (await server.send("POST", "/api/rpc/create_workspace", WEB, {
      workspace: { name: "toodo", description: null, repository: null },
    })).body;
    await server.send("POST", "/api/rpc/create_task", WEB, {
      task: { workspaceId: workspace.id, taskType: "feat", title: "One", description: "", estimate: null, dueDate: null, criteria: [] },
    });
    await until("event: task-status-changed");
    expect(text).toContain(`"workspaceId":${workspace.id},"from":null,"to":"planned"`);
    await reader.cancel();
  });
});

describe("public mode", () => {
  const OAUTH_ROUTES = [
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/openid-configuration"],
    ["POST", "/oauth/register"],
    ["GET", "/oauth/authorize"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/revoke"],
  ] as const;

  test("OAuth routes are absent without a public URL", async () => {
    const web = mkdtempSync(join(tmpdir(), "toodo-web-"));
    writeFileSync(join(web, "index.html"), "Toodo");
    for (const webDir of [undefined, web]) {
      const server = await start({ webDir });
      for (const [method, path] of OAUTH_ROUTES) expect((await server.fetch(method, path)).status).toBe(404);
      const apps = await server.send("POST", "/api/rpc/list_connected_apps", WEB, {});
      expect(apps).toEqual({ status: 200, body: { publicMcpUrl: null, apps: [] } });
    }
  });

  test("a chat app connects over OAuth, uses /mcp, and is revoked from the app", async () => {
    const server = await start({ publicUrl: "https://toodo.example" });
    const verifier = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const redirect = "https://client.example/callback";
    const post = (path: string, body: RequestInit["body"], headers: Record<string, string>, token?: string) =>
      server.fetch("POST", path, { body, headers, token });
    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const formType = { "content-type": "application/x-www-form-urlencoded" };

    const resource: any = await (await server.fetch("GET", "/.well-known/oauth-protected-resource/mcp")).json();
    expect(resource.resource).toBe("https://toodo.example/mcp");
    expect(resource.authorization_servers).toEqual(["https://toodo.example"]);
    const anonymous = await post("/mcp", "{}", { "content-type": "application/json" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://toodo.example/.well-known/oauth-protected-resource/mcp"',
    );

    const registered = await post(
      "/oauth/register",
      JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Chat app" }),
      { "content-type": "application/json" },
    );
    expect(registered.status).toBe(201);
    const clientId: string = ((await registered.json()) as any).client_id;
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "toodo.read toodo.write",
      state: "xyz",
      resource: "https://toodo.example/mcp",
    });
    const page = await (await server.fetch("GET", `/oauth/authorize?${query}`)).text();
    expect(page).toContain("<strong>Chat app</strong> requests access");
    const pendingId = /name="pending_id" value="([0-9a-f]+)"/.exec(page)![1]!;
    const consent = await fetch(`${server.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: formType,
      body: form({ pending_id: pendingId, web_token: WEB, decision: "approve", write: "yes" }),
    });
    expect(consent.status).toBe(303);
    const back = new URL(consent.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe("https://toodo.example");
    const exchanged = await post(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        client_id: clientId,
        code: back.searchParams.get("code")!,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      formType,
    );
    expect(exchanged.status).toBe(200);
    const tokens: any = await exchanged.json();
    expect(tokens.scope).toBe("toodo.read toodo.write");

    const mcp = (token: string, method: string) =>
      post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }), {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }, token);
    const listed = await mcp(tokens.access_token, "tools/list");
    expect(listed.status).toBe(200);
    const names = (((await listed.json()) as any).result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("create_task");
    expect(names).not.toContain("complete_task");
    const upload = await server.fetch("POST", "/mcp/attachments?name=a.txt", { token: tokens.access_token, body: "x" });
    expect(upload.status).toBe(409);
    expect(((await upload.json()) as any).code).toBe("notPermitted");
    expect((await server.fetch("POST", "/mcp/attachments?name=a.txt", { token: AGENT, body: "x" })).status).toBe(201);

    const apps = (await server.send("POST", "/api/rpc/list_connected_apps", WEB, {})).body;
    expect(apps.publicMcpUrl).toBe("https://toodo.example/mcp");
    expect(apps.apps).toHaveLength(1);
    expect(apps.apps[0].clientName).toBe("Chat app");
    expect(apps.apps[0].scopes).toBe("toodo.read toodo.write");
    expect(apps.apps[0].lastUsedAt).not.toBeNull();
    const revoked = await server.send("POST", "/api/rpc/revoke_connected_app", WEB, { grantId: apps.apps[0].grantId });
    expect(revoked.status).toBe(200);
    const after = await mcp(tokens.access_token, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toEndWith(', error="invalid_token"');
    expect((await server.fetch("GET", "/oauth/other")).status).toBe(404);
  });
});

describe("database files", () => {
  test("database files round trip over HTTP", async () => {
    const server = await start();
    addWorkspace(server, "before");
    const exported = await server.fetch("GET", "/api/backups/export", { token: WEB });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(exported.headers.get("content-disposition")).toStartWith('attachment; filename="toodo-backup-');
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe(SQLITE_MAGIC);

    addWorkspace(server, "after");
    const restored = await server.fetch("POST", "/api/backups/restore", { token: WEB, body: bytes });
    expect(restored.status).toBe(200);
    const safety = (await restored.json()) as { kind: string; path: string };
    expect(safety.kind).toBe("preRestore");
    expect(workspaceNames(server)).toEqual(["before"]);

    // The pre-restore backup downloads by name and brings the newer data back.
    const name = (safety.path as string).split("/").pop()!;
    const saved = await server.fetch("GET", `/api/backups/${name}`, { token: WEB });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("content-disposition")).toContain(`filename="${name}"`);
    const savedBytes = await saved.arrayBuffer();
    expect(saved.headers.get("content-length")).toBe(String(savedBytes.byteLength));
    const back = await server.fetch("POST", "/api/backups/restore", { token: WEB, body: savedBytes });
    expect(back.status).toBe(200);
    expect(workspaceNames(server)).toEqual(["before", "after"]);
    // Snapshots and uploads leave nothing behind in the backup directory.
    expect(readdirSync(join(server.dir, "backups")).filter((file) => file.startsWith("."))).toEqual([]);
  });

  test("bad uploads and names change nothing", async () => {
    const server = await start({ restoreLimit: 1024 * 1024 });
    addWorkspace(server, "toodo");
    const restore = (body: RequestInit["body"], token = WEB, headers: Record<string, string> = {}) =>
      server.fetch("POST", "/api/backups/restore", { token, body, headers });
    const junk = await restore("not a database ".repeat(400));
    expect(junk.status).toBe(422);
    expect(await junk.text()).toContain("invalidInput");
    expect((await restore(new Uint8Array(1024 * 1024 + 1))).status).toBe(413);
    // Without a length up front, the limit applies while the body arrives.
    const chunks = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(64 * 1024));
        controller.close();
      },
    });
    expect((await restore(chunks)).status).toBe(413);
    for (const name of ["toodo.sqlite3", "..%2Ftoodo.sqlite3", "toodo-auto-20261014-093005.sqlite3"]) {
      expect((await server.fetch("GET", `/api/backups/${name}`, { token: WEB })).status).toBe(404);
    }
    expect((await server.fetch("GET", "/api/backups/export")).status).toBe(401);
    expect((await restore("", AGENT)).status).toBe(401);
    expect(workspaceNames(server)).toEqual(["toodo"]);
  });
});

describe("chat", () => {
  test("chat attachments go up and come back to people", async () => {
    const server = await start({ attachmentLimit: 64 });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const uploaded = await server.fetch("POST", "/api/chat/attachments?name=shots%2Fscreen.png", {
      token: WEB,
      body: png,
      headers: { "content-type": "image/png" },
    });
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json()) as { id: number };
    expect(attachment).toMatchObject({ name: "screen.png", contentType: "image/png", size: png.length });
    postUserMessage(
      server.services.storage.db,
      { place: { kind: "channel", id: FIRST_CHANNEL }, body: "See", clientId: "c1", attachments: [chatAttachmentId(attachment.id)] },
      server.services.storage.now(),
    );

    const sent = await server.fetch("GET", `/api/chat/attachments/${attachment.id}`, { token: WEB });
    expect(sent.status).toBe(200);
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(png);
    expect(sent.headers.get("content-disposition")).toBe(`inline; filename="screen.png"; filename*=UTF-8''screen.png`);
    expect(sent.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sent.headers.get("content-security-policy")).toStartWith("sandbox");
    expect((await server.fetch("GET", `/api/chat/attachments/${attachment.id}`, { token: AGENT })).status).toBe(401);
    expect((await server.fetch("GET", "/api/chat/attachments/999", { token: WEB })).status).toBe(404);

    const page = (await (await server.fetch("POST", "/api/chat/attachments?name=page.html", {
      token: WEB,
      body: "<script>1</script>",
      headers: { "content-type": "text/html" },
    })).json()) as { id: number };
    const download = await server.fetch("GET", `/api/chat/attachments/${page.id}`, { token: WEB });
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");

    const tooBig = await server.fetch("POST", "/api/chat/attachments?name=big.bin", { token: WEB, body: new Uint8Array(65) });
    expect(tooBig.status).toBe(413);
    const unnamed = await server.fetch("POST", "/api/chat/attachments", { token: WEB, body: "x" });
    expect(unnamed.status).toBe(422);
    // The two uploads kept are the only files: refused ones leave nothing behind.
    expect(readdirSync(join(server.dir, "attachments"))).toHaveLength(2);
  });

  test("choosing an action announces it once", async () => {
    const server = await start();
    const { storage } = server.services;
    const asked = postAgentMessage(
      storage.db,
      { place: null, body: "Deploy?", handles: [], actions: [{ key: "go", label: "Go", style: "primary" }], attachments: [] },
      storage.now(),
    );
    const stream = server.services.events.stream(null);
    const choose = (client: string) =>
      server.send("POST", "/api/rpc/choose_chat_action", WEB, { messageId: asked.id, key: "go", clientId: client });
    const chosen = await choose("k1");
    expect(chosen.status).toBe(200);
    expect(chosen.body.body).toBe("Go");
    expect(chosen.body.choiceOf.key).toBe("go");
    expect((await choose("k2")).status).toBe(409);
    const events = stream.ready();
    expect(events.map((event) => event.name)).toEqual([READY, "chat-action-chosen", "chat-changed"]);
    expect(JSON.parse(events[1]!.data)).toMatchObject({ messageId: asked.id, key: "go", label: "Go", choiceId: chosen.body.id });
  });
});

describe("devices", () => {
  test("devices sign in with the shared token and are revoked alone", async () => {
    const server = await start();
    const appInfo = async (token: string) => (await server.fetch("POST", "/api/rpc/app_info", { token })).status;
    const register = (token: string, label: string) => server.send("POST", "/api/devices", token, { label });

    const phone = await register(WEB, " Phone ");
    expect(phone.status).toBe(201);
    expect(phone.body.token).toHaveLength(64);
    expect(phone.body.device.label).toBe("Phone");
    const laptop = (await register(WEB, "Laptop")).body;
    expect(await appInfo(phone.body.token)).toBe(200);
    const seen = (await server.send("GET", "/api/devices", phone.body.token, undefined)).body as Array<{ label: string; current: boolean }>;
    expect(seen.filter((device) => device.current).map((device) => device.label)).toEqual(["Phone"]);

    // A device token cannot mint more tokens; bad labels are refused.
    expect((await register(phone.body.token, "Spare")).status).toBe(403);
    expect((await register(WEB, "  ")).status).toBe(422);
    expect((await register(AGENT, "MCP")).status).toBe(401);

    const revoked = await server.send("POST", `/api/devices/${phone.body.device.id}/revoke`, laptop.token, {});
    expect(revoked.status).toBe(200);
    expect(typeof revoked.body.revokedAt).toBe("number");
    expect(await appInfo(phone.body.token)).toBe(401);
    expect(await appInfo(laptop.token)).toBe(200);
    expect((await server.send("POST", "/api/devices/99/revoke", WEB, {})).status).toBe(404);
  });

  test("a browser that signs in again keeps its device", async () => {
    const server = await start();
    const register = async (label: string) => (await server.send("POST", "/api/devices", WEB, { label })).body;
    const first = await register("Chrome on Windows");
    await register("Phone");
    const second = await register("Chrome on Windows");
    expect(second.device.id).toBe(first.device.id);
    expect((await server.fetch("POST", "/api/rpc/app_info", { token: first.token })).status).toBe(401);
    expect((await server.fetch("POST", "/api/rpc/app_info", { token: second.token })).status).toBe(200);
    expect((await server.send("GET", "/api/devices", WEB, undefined)).body).toHaveLength(2);
  });

  test("device tokens expire and read-only ones only read", async () => {
    const server = await start();
    const rpc = (command: string, token: string) => server.send("POST", `/api/rpc/${command}`, token, {});
    const laptop = (await server.send("POST", "/api/devices", WEB, { label: "Laptop" })).body;
    expect(laptop.device.scope).toBe("full");
    expect(laptop.device.expiresAt - laptop.device.createdAt).toBe(90 * 86_400);
    const phone = await server.send("POST", "/api/devices", WEB, { label: "Phone", scope: "read", expiresInDays: null });
    expect(phone.status).toBe(201);
    expect(phone.body.device).toMatchObject({ scope: "read", expiresAt: null });
    for (const days of [0, 3651]) {
      const refused = await server.send("POST", "/api/devices", WEB, { label: "Tablet", expiresInDays: days });
      expect(refused.status).toBe(422);
      expect(refused.body.message).toContain("send null");
    }
    const reader = phone.body.token;
    expect((await rpc("list_tasks", reader)).status).toBe(200);
    for (const command of ["create_workspace", "mcp_server_info"]) {
      const refused = await rpc(command, reader);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toContain("read-only");
    }
    expect((await rpc("mcp_server_info", laptop.token)).status).toBe(200);
    expect((await server.send("POST", `/api/devices/${laptop.device.id}/revoke`, reader, {})).status).toBe(403);
    expect((await server.send("POST", `/api/devices/${phone.body.device.id}/revoke`, reader, {})).status).toBe(200);
    expect((await rpc("list_tasks", reader)).status).toBe(401);

    // Once the laptop's 90 days are over, its token stops working and says why.
    const later = laptop.device.expiresAt;
    server.services.storage.setClock(() => later);
    server.services.reader.setClock(() => later);
    const expired = await server.fetch("GET", "/api/devices", { token: laptop.token });
    expect(expired.status).toBe(401);
    expect(await expired.text()).toContain("token has expired");
    expect((await rpc("list_tasks", WEB)).status).toBe(200);
  });

  test("too many wrong tokens lock an address out", async () => {
    const server = await start();
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      expect((await server.fetch("POST", "/api/rpc/app_info", { token: "nope" })).status).toBe(401);
    }
    // Now nothing gets through, not even the right token.
    const locked = await server.fetch("GET", "/api/devices", { token: WEB });
    expect(locked.status).toBe(429);
    const wait = Number(locked.headers.get("retry-after"));
    expect(wait >= 1 && wait <= 60).toBe(true);
    expect(await locked.text()).toContain("too many requests");
  });
});

test("devices subscribe to push notifications and get a test one", async () => {
  const server = await start();
  const token = (await server.send("POST", "/api/devices", WEB, { label: "Phone" })).body.token as string;
  const browser = await Browser.create();
  const subscription = browser.json("https://push.example/send/1");

  const state = await server.send("GET", "/api/push", token, undefined);
  expect(state.status).toBe(200);
  expect(state.body.subscription).toBeNull();
  expect((await server.send("PUT", "/api/push/subscription", WEB, subscription)).status).toBe(403);
  for (const endpoint of ["http://push.example/send/1", "https://127.0.0.1/send/1", "https://10.0.0.5:8443/send/1", "https://private.example/send/1"]) {
    expect((await server.send("PUT", "/api/push/subscription", token, { ...subscription, endpoint })).status).toBe(422);
  }
  expect((await server.send("POST", "/api/push/test", token, {})).status).toBe(404);

  const saved = await server.send("PUT", "/api/push/subscription", token, subscription);
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({
    endpoint: "https://push.example/send/1",
    settings: { completion: true, messages: true, important: true, started: false, finished: false },
    lastFailure: null,
  });
  const chosen = await server.send("PUT", "/api/push/settings", token, {
    completion: true,
    messages: false,
    important: true,
    started: true,
    finished: true,
  });
  expect(chosen.body.settings).toEqual({ completion: true, messages: false, important: true, started: true, finished: true });
  // A web app from before agent messages leaves them out; they stay on for it. One from
  // before the chat and task settings were split keeps the newer settings as saved.
  const legacy = await server.send("PUT", "/api/push/settings", token, { completion: false });
  expect(legacy.body.settings).toEqual({ completion: false, messages: true, important: true, started: true, finished: true });
  expect((await server.send("PUT", "/api/push/settings", token, { completion: false, started: "yes" })).status).toBe(400);
  expect((await server.send("PUT", "/api/push/settings", token, { completion: false, other: 1 })).status).toBe(400);

  expect((await server.send("POST", "/api/push/test", token, {})).status).toBe(200);
  const request = server.transport.requests.shift()!;
  expect(request.endpoint).toBe("https://push.example/send/1");
  expect(((await browser.decryptJson(request.body)) as { tag: string }).tag).toBe("test");
  expect(request.authorization).toEndWith(`, k=${state.body.publicKey}`);

  // A refused test notification shows on the device until one gets through.
  server.transport.statuses.push(403);
  expect((await server.send("POST", "/api/push/test", token, {})).status).toBe(502);
  const failure = (await server.send("GET", "/api/push", token, undefined)).body.subscription.lastFailure;
  expect(failure.message).toBe("the push service refused the notification (403): nope");
  expect((await server.send("POST", "/api/push/test", token, {})).status).toBe(200);
  expect((await server.send("GET", "/api/push", token, undefined)).body.subscription.lastFailure).toBeNull();
  expect((await server.send("DELETE", "/api/push/subscription", token, {})).status).toBe(200);
  expect((await server.send("GET", "/api/push", token, undefined)).body.subscription).toBeNull();
});

test("a Cloudflare Access JWT signs API requests in without a token", async () => {
  const team = "toodo-test.cloudflareaccess.com";
  const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
  const pair = await crypto.subtle.generateKey({ ...rsa, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const certs = new TextEncoder().encode(JSON.stringify({ keys: [{ ...jwk, kid: "kid" }] }));
  const sign = async (exp: number) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `${part({ alg: "RS256", kid: "kid" })}.${part({ iss: `https://${team}`, aud: ["aud"], exp })}`;
    const signature = await crypto.subtle.sign(rsa, pair.privateKey, new TextEncoder().encode(signed));
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  };
  const access = new AccessVerifier(parseAccessConfig(team, "aud"), async () => certs);
  const server = await start({ access });
  const valid = await sign(Math.floor(Date.now() / 1000) + 3600);
  const expired = await sign(1_700_000_000);
  const ask = (method: string, path: string, jwt: string | null, token?: string) =>
    server.fetch(method, path, { token, headers: jwt === null ? {} : { "cf-access-jwt-assertion": jwt } });

  expect((await ask("POST", "/api/rpc/list_workspaces", valid)).status).toBe(200);
  expect(await (await ask("GET", "/api/session", valid)).json()).toEqual({ via: "access" });
  expect(await (await ask("GET", "/api/session", valid, WEB)).json()).toEqual({ via: "token" });
  // A token that does not work no longer matters once Access signed the request in.
  expect((await ask("POST", "/api/rpc/list_workspaces", valid, "nope")).status).toBe(200);
  const device = await server.fetch("POST", "/api/devices", {
    body: JSON.stringify({ label: "Phone" }),
    headers: { "cf-access-jwt-assertion": valid },
  });
  expect(device.status).toBe(201);
  // A device token that works decides alone: Access does not lift a read-only device's limits.
  const reader = (await server.send("POST", "/api/devices", WEB, { label: "Reader", scope: "read" })).body.token;
  expect((await ask("POST", "/api/rpc/create_workspace", valid, reader)).status).toBe(403);
  // Without a valid JWT the token rules hold as before.
  for (const jwt of [null, expired, "not.a.jwt"]) {
    expect((await ask("POST", "/api/rpc/list_workspaces", jwt)).status).toBe(401);
    expect((await ask("POST", "/api/rpc/list_workspaces", jwt, WEB)).status).toBe(200);
  }
});
