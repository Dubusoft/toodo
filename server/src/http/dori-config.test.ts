import { afterEach, describe, expect, test } from "bun:test";

import type { DoriConfigEdit, DoriConfigSaved, DoriConfigStore, DoriConfigView } from "../../../src/lib/dori-config.ts";
import { startTestServer, type TestServer, WEB } from "./http-fixtures.ts";

let servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

const view = (value: string): DoriConfigView => ({
  path: "/home/a/.dori/config.json",
  present: true,
  error: null,
  entries: [{ key: "ownerLanguage", kind: "string", describe: "Language", values: null, required: false, value, access: "edit", restart: false }],
});

function memoryStore(refuse?: { key: string; status: 400 | 403 | 409; message: string }) {
  let value = "Korean";
  const edits: DoriConfigEdit[] = [];
  let release = () => {};
  const slowStarted = Promise.withResolvers<void>();
  const store: DoriConfigStore = {
    view: () => view(value),
    save: async (edit) => {
      edits.push(edit);
      if (edit.key === refuse?.key) return { status: refuse.status, message: refuse.message };
      if (edit.value === "slow") {
        const held = new Promise<void>((resolve) => { release = resolve; });
        slowStarted.resolve();
        await held;
      }
      value = edit.value;
      return { view: view(value), restart: false };
    },
  };
  return { store, edits, slowStarted: slowStarted.promise, release: () => release() };
}

async function start(store?: DoriConfigStore): Promise<TestServer> {
  const server = await startTestServer(store ? { doriConfig: store } : {});
  servers.push(server);
  return server;
}

const put = (server: TestServer, body: unknown, token: string | null = WEB) =>
  server.fetch("PUT", "/api/dori/config", { token: token ?? undefined, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("dori config", () => {
  test("is behind the web gate and missing without a store", async () => {
    const server = await start(memoryStore().store);
    expect((await server.fetch("GET", "/api/dori/config", {})).status).toBe(401);
    expect((await put(server, { key: "ownerLanguage", value: "English" }, null)).status).toBe(401);
    const response = await server.fetch("GET", "/api/dori/config", { token: WEB });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view("Korean"));
    const without = await start();
    expect((await without.fetch("GET", "/api/dori/config", { token: WEB })).status).toBe(404);
    expect((await put(without, { key: "ownerLanguage", value: "English" })).status).toBe(404);
  });

  test("a save answers the store's view, a refusal its status, and a malformed body 400 without reaching the store", async () => {
    const memory = memoryStore({ key: "agentCommand", status: 403, message: "agentCommand is changed only on the host" });
    const server = await start(memory.store);
    const saved = await put(server, { key: "ownerLanguage", value: "English" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ view: view("English"), restart: false });
    const refused = await put(server, { key: "agentCommand", value: "sh" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("agentCommand is changed only on the host");
    for (const body of ["{", "null", { key: "ownerLanguage" }, { key: 1, value: "x" }]) expect((await put(server, body)).status).toBe(400);
    expect(memory.edits).toEqual([{ key: "ownerLanguage", value: "English" }, { key: "agentCommand", value: "sh" }]);
  });

  test("a read-only device sees the config but cannot change it", async () => {
    const memory = memoryStore();
    const server = await start(memory.store);
    const reader = (await server.send("POST", "/api/devices", WEB, { label: "Reader", scope: "read" })).body.token as string;
    expect((await server.fetch("GET", "/api/dori/config", { token: reader })).status).toBe(200);
    expect((await put(server, { key: "ownerLanguage", value: "English" }, reader)).status).toBe(403);
    expect(memory.edits).toEqual([]);
  });

  test("saves run one at a time, in the order they came", async () => {
    const memory = memoryStore();
    const server = await start(memory.store);
    const first = put(server, { key: "ownerLanguage", value: "slow" });
    const second = put(server, { key: "ownerLanguage", value: "English" });
    await memory.slowStarted;
    expect(memory.edits.map((e) => e.value)).toEqual(["slow"]);
    memory.release();
    const value = async (response: Promise<Response>) => ((await (await response).json()) as DoriConfigSaved).view.entries[0]?.value;
    expect(await value(first)).toBe("slow");
    expect(await value(second)).toBe("English");
  });
});
