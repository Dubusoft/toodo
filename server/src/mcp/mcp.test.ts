import { expect, test } from "bun:test";
import type * as B from "../../../src/lib/api.ts";
import { FIRST_CHANNEL, chatMessageId } from "../domain/chat.ts";
import type { Task } from "../domain/model.ts";
import { chooseChatAction, postUserMessage } from "../storage/chat.ts";
import type { Storage } from "../storage/storage.ts";
import { memoryStorage, newTask, workspace } from "../storage/storage-fixtures.ts";
import { VERSION } from "../http/version.ts";
import { tokenHash } from "../http/auth.ts";
import { ownerKey, parseScopes, READ_SCOPES, type Scopes } from "../oauth/scopes.ts";
import { oauthCreateGrant, oauthRegisterClient, oauthRevokeGrant } from "../storage/oauth.ts";
import { CHAT_INSTRUCTIONS, SKILL } from "./instructions.ts";
import { isLoopback, McpEndpoint, type Backend } from "./mcp.ts";
import TOOL_LIST from "./tools.json" with { type: "json" };
import { TOOLS } from "./tools/index.ts";

type Json = Record<string, any>;

/** An MCP endpoint over `storage` that records what it announces, in public mode at
 * `publicUrl` if one is given. */
function endpoint(storage: Storage, publicUrl: string | null = null) {
  const changed: number[] = [];
  const guidelines: number[] = [];
  const chat: string[] = [];
  let workspaces = 0;
  const listeners = new Set<() => void>();
  const changes = () => listeners.forEach((listener) => listener());
  const backend: Backend = {
    storage,
    reader: storage,
    mcp: { url: "http://127.0.0.1:0/mcp", token: "secret", error: null, instance: "0123456789ab", lastRejection: null },
    publicUrl,
    tasksChanged: (id) => {
      changed.push(id);
      changes();
    },
    workspacesChanged: () => workspaces++,
    guidelinesChanged: (id) => guidelines.push(id),
    chatChanged: () => chat.push("changed"),
    agentPosted: (message: B.ChatMessage, notice) => chat.push(`posted ${message.body} in ${notice?.channel ?? "quiet"}`),
    agentTyping: (at, typing) => chat.push(`typing ${typing} in ${JSON.stringify(at)}`),
    actionChosen: (chosen) => chat.push(`chose ${chosen.key}`),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const served = new McpEndpoint(backend, { mcp: "secret", web: "web" });
  return { served, backend, changed, guidelines, chat, workspaces: () => workspaces, announce: changes };
}

function post(served: McpEndpoint, body: unknown, headers: Record<string, string> = {}, address = "127.0.0.1"): Promise<Response> {
  return served.handle(
    new Request("http://127.0.0.1:47616/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    address,
  );
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

async function rpc(served: McpEndpoint, method: string, params: unknown = {}): Promise<Json> {
  const response = await post(served, { jsonrpc: "2.0", id: 1, method, params });
  expect(response.status).toBe(200);
  return (await response.json()) as Json;
}

async function call(served: McpEndpoint, name: string, args: unknown = {}): Promise<Json> {
  return (await rpc(served, "tools/call", { name, arguments: args })).result;
}

/** The value a successful tool call replied with. */
async function value(served: McpEndpoint, name: string, args: unknown = {}): Promise<any> {
  const result = await call(served, name, args);
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
}

function storageWithTask(): [Storage, Task] {
  const storage = memoryStorage();
  const created = storage.createTask(newTask(workspace(storage, "Tasks"), "Add login"));
  return [storage, created];
}

test("The tool list is the Rust server's, every tool of it served", async () => {
  const { served } = endpoint(memoryStorage());
  const listed = (await rpc(served, "tools/list")).result.tools as Array<{ name: string; inputSchema: Json }>;
  expect(listed).toEqual(TOOL_LIST as never);
  expect(listed.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOLS).sort());
  expect(listed).toHaveLength(50);
  const start = listed.find((tool) => tool.name === "start_task");
  expect(start?.inputSchema.properties.agent_command).toBeUndefined();
});

test("A ready start records reason and refs and announces the change", async () => {
  const [storage, task] = storageWithTask();
  const { served, changed } = endpoint(storage);
  const started = await value(served, "start_task", { id: task.id, reason: "Ready", refs: ["lane:test"] });
  expect(started.status).toBe("in_progress");
  expect(started.guidelines).toEqual([]);
  expect(started.refs).toEqual(["lane:test"]);
  expect(started.timeline[1].reason).toBe("Ready");
  for (const field of ["panes", "ranIn", "paneError", "worktreePath"]) expect(started[field]).toBeUndefined();
  expect(changed).toEqual([started.workspaceId]);
  expect((await value(served, "current_task", { ref: "lane:test" })).id).toBe(task.id);
  const missing = await call(served, "current_task", {});
  expect(missing.isError).toBe(true);
  expect(missing.content[0].text).toContain("get_task");
  expect(missing.content[0].text).toContain("ref");
});

test("Review status, pause, and resume go through the task history", async () => {
  const [storage, task] = storageWithTask();
  const { served } = endpoint(storage);
  await value(served, "start_task", { id: task.id });
  const reviewed = await value(served, "update_task", { id: task.id, status: "in_review", refs: ["review:ready"] });
  expect(reviewed.status).toBe("in_review");
  expect(reviewed.milestones.reviewAt).not.toBeNull();
  await value(served, "pause_task", { id: task.id, reason: "Waiting" });
  const resumed = await value(served, "resume_task", { id: task.id, note: "Ready again" });
  expect(resumed.status).toBe("in_progress");
  expect(resumed.refs).toEqual(["review:ready"]);
  expect(resumed.notes.at(-1).body).toBe("Resumed: Ready again");
});

test("Only requests with the token reach the tools", async () => {
  const { served, backend } = endpoint(memoryStorage());
  const rejected = async (authorization: string | null, reason: string) => {
    const headers: Record<string, string> = authorization === null ? {} : { authorization };
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(initialize),
    });
    const response = await served.handle(request, "127.0.0.1");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const text = await response.text();
    expect(text).toContain(reason);
    expect(text).toContain("This is Toodo server instance 0123456789ab.");
    expect(text).not.toContain("secret");
  };
  await rejected(null, "has no Authorization header");
  await rejected("secret", "is not `Bearer <token>`");
  await rejected("Bearer ", "is not `Bearer <token>`");
  await rejected("Bearer secreT", "this server does not accept the token");
  await rejected("Bearer web", "the web sign-in token");
  expect(backend.mcp.lastRejection).toMatchObject({ reason: "web_token", count: 5 });

  const accepted = await post(served, initialize);
  expect(accepted.status).toBe(200);
  const body = (await accepted.json()) as Json;
  expect(body.result.serverInfo).toEqual({ name: "toodo", title: "Toodo (server instance 0123456789ab)", version: VERSION });
  // The scheme is case-insensitive.
  expect((await post(served, initialize, { authorization: "bearer secret" })).status).toBe(200);
  expect(backend.mcp.lastRejection?.count).toBe(5);
});

test("An address that keeps sending a wrong token is locked out", async () => {
  const { served } = endpoint(memoryStorage());
  for (let i = 0; i < 20; i++) expect((await post(served, initialize, { authorization: "Bearer wrong" })).status).toBe(401);
  const locked = await post(served, initialize);
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await post(served, initialize, {}, "127.0.0.2")).status).toBe(200);
});

test("The skill tool returns the skill text", async () => {
  const { served } = endpoint(memoryStorage());
  const result = await call(served, "read_toodo_skill");
  expect(result).toEqual({ content: [{ type: "text", text: SKILL }], isError: false });
  expect(SKILL.split(/\r?\n/).slice(0, 2)).toEqual(["---", "name: toodo"]);
  expect(TOOLS.import_chat_message).toBeUndefined();
});

test("Guideline tools announce changes and start_task returns the guidelines", async () => {
  const [storage, task] = storageWithTask();
  const { served, guidelines } = endpoint(storage);
  const ws = task.workspaceId;
  const rule = await value(served, "add_guideline", { workspace_id: ws, kind: "rule", body: "Write English" });
  const memory = await value(served, "add_guideline", { workspace_id: ws, body: "Tests take a minute" });
  expect(memory.kind).toBe("memory");
  const updated = await value(served, "update_guideline", { id: memory.id, body: "Tests take two minutes" });
  expect(updated.kind).toBe("memory");
  const started = await value(served, "start_task", { id: task.id });
  expect(started.status).toBe("in_progress");
  expect(started.guidelines).toEqual([rule, updated]);
  await value(served, "remove_guideline", { id: rule.id });
  const listed = await value(served, "get_guidelines", { workspace_id: ws });
  expect(listed.workspace).toEqual({ id: ws, name: "Tasks" });
  expect(listed.guidelines).toEqual([updated]);
  expect(guidelines).toEqual([ws, ws, ws, ws]);
});

test("The agent offers actions, receives the choice, and searches the chat", async () => {
  const storage = memoryStorage();
  const { served } = endpoint(storage);
  const asked = await value(served, "reply_in_chat", {
    body: "Release the build?",
    actions: [{ key: "release", label: "Release", style: "primary" }, { key: "hold", label: "Hold" }],
  });
  expect(asked.actions[1].style).toBe("default");
  const duplicate = await call(served, "reply_in_chat", { body: "Twice", actions: [{ key: "a", label: "A" }, { key: "a", label: "B" }] });
  expect(duplicate.isError).toBe(true);
  chooseChatAction(storage.db, { message: chatMessageId(asked.id), key: "hold", clientId: "k1" }, storage.now());
  const taken = await value(served, "take_pending");
  expect([taken[0].body, taken[0].choiceOf.messageId, taken[0].choiceOf.key]).toEqual(["Hold", asked.id, "hold"]);
  const hits = await value(served, "search_chat", { query: "release BUILD" });
  expect(hits).toHaveLength(1);
  expect([hits[0].message.id, hits[0].channelName]).toEqual([asked.id, "general"]);
});

test("Chat tools take, acknowledge, and answer messages and announce each step", async () => {
  const storage = memoryStorage();
  const general = { kind: "channel", id: FIRST_CHANNEL } as const;
  const hi = postUserMessage(storage.db, { place: general, body: "Hi", clientId: "c1", attachments: [] }, storage.now());
  const later = postUserMessage(storage.db, { place: general, body: "Also", clientId: "c2", attachments: [] }, storage.now());
  const { served, chat } = endpoint(storage);
  const peeked = await value(served, "peek_pending");
  expect(peeked).toHaveLength(2);
  expect(peeked[0].deliveredAt).toBeNull();
  const taken = await value(served, "take_pending");
  expect(taken[0].id).toBe(hi.id);
  expect(taken[0].deliveredAt).not.toBeNull();
  expect(await value(served, "take_pending")).toEqual([]);
  const acked = await value(served, "ack_chat", { ids: [hi.id] });
  expect(acked[0].ackedAt).not.toBeNull();
  await value(served, "set_typing", { typing: true });
  await value(served, "set_typing", { typing: true, thread_id: 4 });
  const both = await call(served, "set_typing", { typing: true, channel_id: 1, thread_id: 4 });
  expect(both.structuredContent.error.code).toBe("invalidInput");
  const reply = await value(served, "reply_in_chat", { body: "Hello", handles: [hi.id] });
  expect(reply.author).toBe("agent");
  const handled = await value(served, "mark_chat_handled", { id: later.id, reply_id: reply.id });
  expect(handled.handledReplyId).toBe(reply.id);
  const listed = await value(served, "list_chat", {});
  expect(listed[0].handledReplyId).toBe(reply.id);
  expect(chat).toEqual([
    "changed",
    "changed",
    'typing true in {"channel":1}',
    'typing true in {"thread":4}',
    "posted Hello in general",
    "changed",
  ]);
  const refused = await call(served, "ack_chat", { ids: [reply.id] });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error.code).toBe("rejected");
});

test("Thread tools open, close, and archive a thread", async () => {
  const { served, chat } = endpoint(memoryStorage());
  const work = await value(served, "create_channel", { name: "#work" });
  expect(work.name).toBe("work");
  const thread = await value(served, "create_thread", { channel_id: work.id, title: "Deploy" });
  expect(thread.status).toBe("open");
  const posted = await value(served, "reply_in_chat", { body: "Starting", thread_id: thread.id });
  expect([posted.channelId, posted.threadId]).toEqual([work.id, thread.id]);
  for (const status of ["closed", "archived"]) {
    expect((await value(served, "update_thread", { id: thread.id, status })).status).toBe(status);
  }
  expect(await value(served, "list_threads", {})).toEqual([]);
  const archived = await value(served, "list_threads", { include_archived: true });
  expect(archived[0].status).toBe("archived");
  expect(archived[0].closedAt).not.toBeNull();
  expect(archived[0].archivedAt).not.toBeNull();
  const refused = await call(served, "reply_in_chat", { body: "Late", thread_id: thread.id });
  expect(refused.structuredContent.error.code).toBe("rejected");
  const both = await call(served, "reply_in_chat", { body: "Hi", channel_id: 1, thread_id: thread.id });
  expect(both.isError).toBe(true);
  expect(chat).toEqual(["changed", "changed", "posted Starting in work", "changed", "changed"]);
});

test("Thread tools set, list, and clear the waiting mark and announce both changes", async () => {
  const storage = memoryStorage();
  const { served, chat } = endpoint(storage);
  const created = await value(served, "create_thread", { title: "Deploy" });
  expect(created.awaitingAt).toBeNull();

  const marked = await value(served, "update_thread", { id: created.id, awaiting: true });
  expect(marked.awaitingAt).toBe(storage.now());
  expect(await value(served, "list_threads")).toEqual([marked]);

  const cleared = await value(served, "update_thread", { id: created.id, title: "Deploy approved", awaiting: false });
  expect(cleared).toMatchObject({ title: "Deploy approved", awaitingAt: null });
  expect(chat).toEqual(["changed", "changed", "changed"]);
});

test("A task id sent as a string reaches the tool", async () => {
  const [storage, task] = storageWithTask();
  const { served } = endpoint(storage);
  expect((await value(served, "get_task", { id: String(task.id) })).task.title).toBe("Add login");
  const rejected = await call(served, "get_task", { id: "login" });
  expect(rejected.isError).toBe(true);
  expect(rejected.content[0].text).toStartWith('InvalidInput: id must be a whole number such as 12 or "12", not "login"');
  expect(rejected.structuredContent.error.code).toBe("invalidArguments");
  const missing = await call(served, "get_task", { id: 999 });
  expect(missing.structuredContent.error).toEqual({ code: "taskNotFound", kind: "notFound", message: "task 999 does not exist" });
});

test("Arguments that do not fit the tool fail with the serde message", async () => {
  const { served } = endpoint(memoryStorage());
  expect(await call(served, "get_task", {})).toEqual({
    content: [{ type: "text", text: "failed to deserialize parameters: missing field `id`" }],
    isError: true,
  });
  const unknown = await call(served, "check_criterion", { criterion_id: 1, bogus: 1 });
  expect(unknown.content[0].text).toBe(
    "failed to deserialize parameters: unknown field `bogus`, expected one of `task_id`, `criterion_id`, `id`, `met`, `evidence`",
  );
  expect((await rpc(served, "tools/call", { name: "no_such_tool", arguments: {} })).error).toEqual({ code: -32602, message: "tool not found" });
});

/** A task that depends on `storageWithTask`'s, served by an endpoint. */
function endpointWithDependent() {
  const [storage, task] = storageWithTask();
  const tasks = storage.getWorkspace(task.workspaceId);
  if (tasks === null) throw new Error("the workspace of the task exists");
  const dependent = storage.createTask(newTask(tasks, "Add logout"));
  storage.addDependency(dependent.id, task.id);
  return { ...endpoint(storage), storage, task, dependent };
}

test("Tasks that are not done are resources", async () => {
  const { served, task, dependent } = endpointWithDependent();
  const taskUri = `toodo://tasks/${task.id}`;
  const dependentUri = `toodo://tasks/${dependent.id}`;
  const listed = (await rpc(served, "resources/list")).result.resources as Json[];
  expect(listed.map((resource) => resource.uri)).toEqual([taskUri, dependentUri]);
  expect(listed[0]).toEqual({ uri: taskUri, name: `task-${task.id}`, title: `#${task.id} Add login`, mimeType: "application/json" });
  const templates = (await rpc(served, "resources/templates/list")).result.resourceTemplates as Json[];
  expect(templates.map((template) => template.uriTemplate)).toEqual(["toodo://tasks/{task_id}"]);
  const read = (await rpc(served, "resources/read", { uri: dependentUri })).result.contents[0];
  expect(read.uri).toBe(dependentUri);
  expect(JSON.parse(read.text)).toEqual(await value(served, "get_task", { id: dependent.id }));
  const missing = await rpc(served, "resources/read", { uri: "toodo://tasks/999" });
  expect(missing.error.code).toBe(-32002);
  expect(missing.error.message).toContain("search_tasks");
});

test("Initialize does not offer resource subscriptions", async () => {
  const { served } = endpointWithDependent();
  const body = (await (await post(served, initialize)).json()) as Json;
  expect(body.result.capabilities).toEqual({ resources: {}, tools: {} });
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** The messages of an event stream, one at a time, each within a second. */
function messages(response: Response): () => Promise<Json> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) return JSON.parse(data.slice(6)) as Json;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("no message within a second")), 1000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error("the stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

test("A listen stream reports a completed dependency", async () => {
  const { served, storage, task, dependent, announce } = endpointWithDependent();
  const dependentUri = `toodo://tasks/${dependent.id}`;
  const closed = new AbortController();
  const response = await served.handle(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      signal: closed.signal,
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "subscriptions/listen",
        params: {
          _meta: META,
          notifications: { resourceSubscriptions: [dependentUri, "https://example.com/elsewhere"], resourcesListChanged: true },
        },
      }),
    }),
    "127.0.0.1",
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const next = messages(response);
  const acknowledged = await next();
  expect(acknowledged.method).toBe("notifications/subscriptions/acknowledged");
  expect(acknowledged.params.notifications).toEqual({ resourceSubscriptions: [dependentUri], resourcesListChanged: true });

  storage.setTaskStatus(task.id, "in_progress");
  storage.completeTask(task.id, "Shipped", []);
  announce();

  const updated = await next();
  expect(updated.method).toBe("notifications/resources/updated");
  expect(updated.params).toEqual({ _meta: { "io.modelcontextprotocol/subscriptionId": 7 }, uri: dependentUri });
  expect((await next()).method).toBe("notifications/resources/list_changed");
  closed.abort();
});

test("A request of the 2026-07-28 protocol carries its version and method in headers", async () => {
  const { served } = endpoint(memoryStorage());
  const request = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_workspaces", arguments: {}, _meta: META } };
  const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" };
  const missingName = await post(served, request, headers);
  expect(missingName.status).toBe(400);
  expect(((await missingName.json()) as Json).error).toEqual({ code: -32020, message: "missing required Mcp-Name header for `tools/call`" });
  const called = await post(served, request, { ...headers, "mcp-name": "list_workspaces" });
  expect(await called.json()).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: { resultType: "complete", content: [{ type: "text", text: "[]" }], isError: false },
  });
  const ping = await post(served, { jsonrpc: "2.0", id: 3, method: "ping", params: { _meta: META } }, { ...headers, "mcp-method": "ping" });
  expect(ping.status).toBe(404);
  const discovered = await post(served, { jsonrpc: "2.0", id: 4, method: "server/discover", params: { _meta: META } }, { ...headers, "mcp-method": "server/discover" });
  const discovery = ((await discovered.json()) as Json).result;
  expect(discovery.capabilities).toEqual({ resources: { subscribe: true, listChanged: true }, tools: {} });
  expect(discovery._meta["io.modelcontextprotocol/serverInfo"].version).toBe(VERSION);
});

test("Transport checks answer as rmcp does", async () => {
  const { served } = endpoint(memoryStorage());
  expect((await post(served, initialize, { accept: "application/json" })).status).toBe(406);
  expect((await post(served, initialize, { "content-type": "text/plain" })).status).toBe(415);
  const malformed = await post(served, "{not json");
  expect([malformed.status, await malformed.text()]).toEqual([415, "fail to deserialize request body key must be a string at line 1 column 2"]);
  expect((await post(served, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  const unknownVersion = await post(served, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  expect([unknownVersion.status, await unknownVersion.text()]).toEqual([400, "Bad Request: Unsupported MCP-Protocol-Version: 1999-01-01"]);
  const get = await served.handle(new Request("http://127.0.0.1/mcp", { headers: { authorization: "Bearer secret" } }), "127.0.0.1");
  expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
  const rebound = await served.handle(
    new Request("http://evil.example/mcp", { method: "POST", headers: { authorization: "Bearer secret", host: "evil.example" }, body: "{}" }),
    "127.0.0.1",
  );
  expect(rebound.status).toBe(403);
});

test("Loopback addresses are those of this machine", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(address)).toBe(true);
  for (const address of ["192.0.2.1", "::ffff:192.0.2.1", "10.0.0.1", null]) expect(isLoopback(address)).toBe(false);
});

test("Only loopback peers are served, an IPv4 one mapped into IPv6 included", async () => {
  const { served } = endpoint(memoryStorage());
  const remote = await post(served, initialize, {}, "192.0.2.1");
  expect(remote.status).toBe(403);
  expect(await remote.text()).toContain("TOODO_PUBLIC_URL");
  expect((await post(served, initialize, {}, "::ffff:127.0.0.1")).status).toBe(200);
});

test("In public mode chat apps reach the tools their OAuth grant allows from anywhere", async () => {
  const storage = memoryStorage();
  const { served } = endpoint(storage, "https://toodo.example:8443");
  const grant = (token: string, scopes: Scopes) => {
    const client = {
      clientId: `client-${token}`,
      secretHash: null,
      clientName: "Test app",
      redirectUris: ["https://client.example/callback"],
      authMethod: "none",
      createdAt: 1,
    };
    oauthRegisterClient(storage.db, client, storage.now());
    const tokens = { accessHash: tokenHash(token), refreshHash: tokenHash(`${token}-refresh`) };
    return oauthCreateGrant(storage.db, { owner: ownerKey("test-owner"), client, scopes, tokens }, storage.now());
  };
  const readGrant = grant("read-access", READ_SCOPES);
  grant("write-access", parseScopes("toodo.write"));
  const send = (token: string | null, body: unknown, host = "toodo.example:8443") =>
    served.handle(
      new Request(`https://${host}/mcp`, {
        method: "POST",
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      }),
      "192.0.2.1",
    );
  const rpcAs = async (token: string, method: string, params: unknown = {}) => {
    const response = await send(token, { jsonrpc: "2.0", id: 1, method, params });
    expect(response.status).toBe(200);
    return ((await response.json()) as Json).result;
  };
  const toolList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  for (const host of ["toodo.example", "toodo.example:8443", "localhost", "127.0.0.1"]) {
    expect((await send("secret", toolList, host)).status).toBe(200);
  }
  expect((await send("secret", toolList, "other.example")).status).toBe(403);

  const anonymous = await send(null, initialize);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="https://toodo.example:8443/.well-known/oauth-protected-resource/mcp"',
  );
  expect((await send("unknown", initialize)).headers.get("www-authenticate")).toEndWith(', error="invalid_token"');
  const chat = (await (await send("read-access", initialize)).json()) as Json;
  expect(chat.result.instructions).toBe(CHAT_INSTRUCTIONS);
  expect(chat.result.instructions).not.toContain("Call current_task");

  const names = async (token: string) =>
    new Set(((await rpcAs(token, "tools/list")).tools as Json[]).map((tool) => tool.name as string));
  const read = await names("read-access");
  const READ = ["read_toodo_skill", "list_workspaces", "list_tasks", "search_tasks", "get_task", "get_guidelines", "review_report"];
  expect(read).toEqual(new Set(READ));
  const all = await names("secret");
  expect(all).toEqual(new Set(TOOL_LIST.map((tool) => tool.name)));
  const write = await names("write-access");
  expect(write).toEqual(
    new Set([
      ...READ,
      ...["create_workspace", "create_task", "create_plan", "update_task", "move_task", "add_dependency"],
      ...["remove_dependency", "add_related", "remove_related", "add_criterion", "remove_criterion"],
      ...["check_criterion", "add_progress_note", "report_blocker", "pause_task", "wait_task"],
      ...["add_guideline", "update_guideline", "remove_guideline"],
    ]),
  );
  for (const name of ["current_task", "start_task", "resume_task", "end_wait", "update_workspace", "archive_workspace", "complete_task", "conclude_task", "delete_task", "delete_done_tasks", "reopen_task"]) {
    expect(write.has(name)).toBe(false);
    expect(all.has(name)).toBe(true);
    const refused = await rpcAs("write-access", "tools/call", { name, arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("local-only");
    expect(refused.structuredContent.error.code).toBe("notPermitted");
  }
  const callAs = (token: string, name: string, args: unknown) => rpcAs(token, "tools/call", { name, arguments: args });
  const refused = await callAs("read-access", "create_task", {});
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("toodo.write");
  expect((await callAs("read-access", "read_toodo_skill", {})).content[0].text).toBe(CHAT_INSTRUCTIONS);
  for (const extra of [{ clone_url: "https://example.com/repo" }, { init: true }, { source: "github" }]) {
    const rejected = await callAs("write-access", "create_workspace", { name: "Planning", ...extra });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("name");
  }
  const created = await callAs("write-access", "create_workspace", { name: "Planning" });
  expect(created.isError).toBe(false);
  const workspace = JSON.parse(created.content[0].text);
  const task = await callAs("write-access", "create_task", { workspace_id: workspace.id, task_type: "feat", title: "Plan the feature" });
  expect(task.isError).toBe(false);
  expect((await rpcAs("read-access", "resources/list")).resources).toHaveLength(1);

  oauthRevokeGrant(storage.db, readGrant, storage.now());
  const revoked = await send("read-access", initialize);
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get("www-authenticate")).toContain('error="invalid_token"');
});
