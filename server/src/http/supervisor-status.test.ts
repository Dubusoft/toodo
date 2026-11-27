import { afterEach, describe, expect, test } from "bun:test";

import type { SupervisorStatusSnapshot } from "../../../src/lib/supervisor-status.ts";
import { AGENT, startTestServer, type TestServer, WEB } from "./http-fixtures.ts";
import { createHandler } from "./server.ts";

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

const snapshot = (at: number): SupervisorStatusSnapshot => ({
  at,
  status: ["Dori status · 10-21 09:53 KST"],
  quota: { text: "Claude default: 5h 12%", fetchedAt: at - 40_000 },
  lanes: [{ key: "ap-1-1", task: 1, machine: "local", model: null, ageMin: 3, progress: null, screen: { text: "$ bun test" } }],
});

async function events(response: Response, count: number): Promise<{ event: string; data: string }[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const found: { event: string; data: string }[] = [];
  let buffer = "";
  while (found.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      if (event !== undefined) found.push({ event, data: /^data: (.*)$/m.exec(block)?.[1] ?? "" });
    }
  }
  await reader.cancel();
  return found;
}

describe("supervisor status", () => {
  test("only the MCP token may push, and only a snapshot", async () => {
    const server = await start();
    const push = (token: string | undefined, body: unknown) =>
      server.fetch("PUT", "/mcp/supervisor-status", { token, body: JSON.stringify(body) });
    expect((await push(undefined, snapshot(1))).status).toBe(401);
    expect((await push(WEB, snapshot(1))).status).toBe(401);
    expect((await push("nope", snapshot(1))).status).toBe(401);
    expect((await push(AGENT, { at: 1 })).status).toBe(400);
    expect((await server.fetch("PUT", "/mcp/supervisor-status", { token: AGENT, body: "{" })).status).toBe(400);
    expect((await server.fetch("POST", "/mcp/supervisor-status", { token: AGENT })).status).toBe(405);
    const accepted = await push(AGENT, snapshot(1));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ watchers: 0 });
  });

  test("a push from another machine is refused even with the MCP token in public mode", async () => {
    const server = await start({ publicUrl: "https://toodo.example" });
    const handle = createHandler({
      services: server.services,
      webToken: WEB,
      mcpToken: AGENT,
      access: null,
      webDir: null,
      clientMetadata: async () => { throw new Error("none"); },
    });
    const request = (peer: string) =>
      handle(
        new Request("http://toodo.example/mcp/supervisor-status", {
          method: "PUT",
          headers: { authorization: `Bearer ${AGENT}`, host: "toodo.example" },
          body: JSON.stringify(snapshot(1)),
        }),
        { peer, keepOpen: () => {} },
      );
    const remote = await request("203.0.113.9");
    expect(remote.status).toBe(409);
    expect(await remote.text()).toContain("the supervisor status is local-only");
    expect((await request("127.0.0.1")).status).toBe(200);
  });

  test("a panel needs the web token, gets the latest snapshot first, then each push, and is counted while open", async () => {
    const server = await start();
    expect((await server.fetch("GET", "/api/supervisor/status")).status).toBe(401);
    expect((await server.fetch("GET", "/api/supervisor/status", { token: AGENT })).status).toBe(401);

    const early = await server.fetch("GET", "/api/supervisor/status", { token: WEB });
    expect(early.headers.get("content-type")).toBe("text/event-stream");
    expect((await events(early, 1)).map((event) => event.event)).toEqual(["ready"]);

    await server.send("PUT", "/mcp/supervisor-status", AGENT, snapshot(1));
    const panel = await server.fetch("GET", "/api/supervisor/status", { token: WEB });
    const count = await server.send("GET", "/mcp/supervisor-status", AGENT, undefined);
    expect(count.body).toEqual({ watchers: 1 });
    const pushed = await server.send("PUT", "/mcp/supervisor-status", AGENT, snapshot(2));
    expect(pushed.body).toEqual({ watchers: 1 });
    const seen = await events(panel, 2);
    expect(seen.map((event) => event.event)).toEqual(["status", "status"]);
    expect(seen.map((event) => JSON.parse(event.data))).toEqual([snapshot(1), snapshot(2)]);
  });
});
